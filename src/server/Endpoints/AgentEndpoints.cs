using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.EntityFrameworkCore;
using PipelineLaunchpad.Server.Data;
using PipelineLaunchpad.Server.Models;
using PipelineLaunchpad.Server.Services;
using PipelineLaunchpad.Server.Services.Agents;

namespace PipelineLaunchpad.Server.Endpoints;

/// <summary>
/// Connection tests and the question stream (DESIGN_SPEC_CONNECTORS.md §4 and §6).
///
/// Separate from <see cref="ConnectorEndpoints"/> because these are the routes that actually call a
/// provider: everything here needs an adapter, and nothing there does.
/// </summary>
public static class AgentEndpoints
{
    private static readonly JsonSerializerOptions Sse = new(JsonSerializerDefaults.Web)
    {
        // The stream carries prose with angle brackets and quotes in it; the default encoder would
        // turn a diff snippet into a wall of \uXXXX before the browser ever saw it.
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public static void MapAgents(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        // Pre-save test (§4). Takes a credential that has never been stored, which is the only way
        // "Save is disabled until the connection has tested green" can be true for a new connector.
        api.MapPost("/connectors/test", async (
            TestConnectorRequest body, AdoContext ctx, AgentRegistry registry, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();
            if (!ConnectorProviders.IsKnown(body.Provider))
                return Results.BadRequest(new { error = "Unknown provider." });
            if (string.IsNullOrWhiteSpace(body.Token))
                return Results.BadRequest(new { error = "A credential is required to test a connection." });

            var adapter = registry.For(body.Provider);
            if (adapter is null)
                return Results.BadRequest(new { error = $"No adapter is built for {body.Provider} yet." });

            var target = AgentRegistry.TargetFor(body.Provider, body.BaseUrl, body.Token.Trim());
            var probe = await adapter.ProbeAsync(target, ct);
            return Results.Ok(ToDto(probe));
        });

        // Test a saved connector, and record the outcome — the row's status and the panel's outage
        // banner both read from what this writes.
        api.MapPost("/connectors/{id}/test", async (
            string id, AdoContext ctx, AppDbContext db, AgentRegistry registry, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();

            var connector = await db.Connectors.FirstOrDefaultAsync(c => c.Id == id && c.UserId == ctx.UserId, ct);
            if (connector is null) return Results.NotFound();

            var adapter = registry.For(connector.Provider);
            if (adapter is null)
                return Results.BadRequest(new { error = $"No adapter is built for {connector.Provider} yet." });

            var target = registry.TargetFor(connector);
            if (target is null)
                return Results.Ok(ToDto(new AgentProbe(false, 0, [], new AgentError(AgentErrorCode.Auth,
                    Detail: "The stored credential could not be read. Press Replace and paste it again."))));

            var probe = await adapter.ProbeAsync(target, ct);
            Record(connector, probe);
            await db.SaveChangesAsync(ct);

            return Results.Ok(ToDto(probe));
        });

        // The question stream (§6). One SSE shape reaches the browser regardless of which adapter
        // produced it — normalising that difference away is the adapter's job, not the client's.
        api.MapPost("/review/{project}/{repoId}/pulls/{prId:int}/ask", async (
            string project, string repoId, int prId, AskRequest body,
            HttpContext http, AdoContext ctx, AppDbContext db,
            AgentRegistry registry, AdoService ado, PrContextService contexts,
            ThreadStore threads, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) { http.Response.StatusCode = 401; return; }

            if (string.IsNullOrWhiteSpace(body.Question))
            {
                http.Response.StatusCode = 400;
                await http.Response.WriteAsJsonAsync(new { error = "A question is required." }, ct);
                return;
            }

            // Whichever connector holds the capability — never a named provider (§0).
            var holder = await db.ConnectorCapabilities
                .FirstOrDefaultAsync(c => c.UserId == ctx.UserId && c.Capability == ConnectorProviders.PrQuestions, ct);

            var connector = holder is null ? null
                : await db.Connectors.FirstOrDefaultAsync(c => c.Id == holder.ConnectorId, ct);

            if (connector is null)
            {
                // §7.2's Not connected is a UI state, not an error — but a request that gets here
                // with nothing assigned is a client bug, so it says so plainly.
                http.Response.StatusCode = 409;
                await http.Response.WriteAsJsonAsync(new { error = "No connector is assigned to answer PR questions." }, ct);
                return;
            }

            var adapter = registry.For(connector.Provider);
            var target = registry.TargetFor(connector);

            StartSse(http);

            if (adapter is null || target is null)
            {
                await Send(http, "error", new
                {
                    code = "auth",
                    detail = adapter is null
                        ? $"No adapter is built for {connector.Provider} yet."
                        : "The stored credential could not be read. Press Replace and paste it again.",
                }, ct);
                return;
            }

            // Building the context needs several ADO calls; a failure there is Launchpad's, not the
            // agent's, and saying so stops a reviewer diagnosing the wrong service.
            PrContext context;
            PullRequestDto? pr;
            try
            {
                var pulls = await ado.GetPullRequestsAsync(project, repoId, "all", 200, ct);
                pr = pulls.FirstOrDefault(p => p.Id == prId);
                if (pr is null)
                {
                    await Send(http, "error", new { code = "upstream", detail = "That pull request could not be read from Azure DevOps." }, ct);
                    return;
                }
                context = await contexts.BuildAsync(project, repoId, pr, body.Question, ct);
            }
            catch (AdoService.AdoException ex)
            {
                await Send(http, "error", new { code = "upstream", detail = $"Azure DevOps: {ex.Message}" }, ct);
                return;
            }

            await Send(http, "context", new
            {
                truncated = context.Truncated,
                omitted = context.OmittedPaths,
                diffBytes = context.DiffBytes,
                connector = new { connector.Name, connector.Provider, connector.Model },
            }, ct);

            // History comes from the thread, not the client. §7.5: Launchpad owns the conversation,
            // which is what keeps connectors stateless and lets the provider change mid-thread.
            var thread = await threads.GetOrCreateAsync(ctx.UserId!, project, repoId, prId, ct);
            var history = await threads.ReplayAsync(thread.Id, ct);

            var request = new CanonicalRequest(
                SystemPrompt: TaskPrompt.Structured(context.Truncated),
                Context: context.Xml,
                History: history,
                Question: body.Question,
                Model: connector.Model ?? "",
                Stream: true);

            await Send(http, "turn", new { threadId = thread.Id, replayedTurns = history.Count }, ct);

            CanonicalAnswer? answer = null;
            AgentUsage? usage = null;
            AgentError? failure = null;
            var stopped = false;

            try
            {
                await foreach (var ev in adapter.CompleteAsync(target, request, ct))
                {
                    switch (ev)
                    {
                        case AgentEvent.Delta d:
                            await Send(http, "delta", new { text = d.Text }, ct);
                            break;

                        case AgentEvent.Complete c:
                            answer = c.Answer;
                            usage = c.Usage;
                            break;

                        case AgentEvent.Failed f:
                            failure = f.Error;
                            break;
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // The reviewer pressed Stop, or navigated away. §5.5 keeps the partial answer in the
                // thread marked Stopped, and §7.4 makes it unpostable — so it is recorded rather
                // than discarded, but never becomes a PR comment.
                stopped = true;
            }

            var turn = await threads.AppendAsync(
                thread, body.Question, answer, connector, pr.SourceCommit, usage,
                stopped, failure?.Code,
                // The request's own token is already cancelled when the reviewer stops, so the
                // write needs one that isn't, or the record of the stop is itself lost.
                stopped ? CancellationToken.None : ct);

            if (failure is not null)
            {
                await Send(http, "error", new
                {
                    code = failure.Code.ToString().ToLowerInvariant(),
                    httpStatus = failure.HttpStatus,
                    detail = failure.Detail,
                    retryAfter = failure.RetryAfterSeconds,
                    turnId = turn.Id,
                }, ct);
            }
            else if (!stopped && answer is not null)
            {
                await Send(http, "complete", ToTurnDto(turn), ct);
            }

            // Record the outcome so Settings shows what the panel just experienced, rather than the
            // two disagreeing about whether the agent is reachable.
            if (failure is null && !stopped) connector.LastOkAt = DateTime.UtcNow;
            if (failure is not null) connector.LastErrorAt = DateTime.UtcNow;
            await db.SaveChangesAsync(stopped ? CancellationToken.None : ct);
        });

        // The thread as the panel renders it on load. Includes the PR head so the stale-commit
        // banner can compare against what each turn was actually answered about (§7.3).
        api.MapGet("/review/{project}/{repoId}/pulls/{prId:int}/thread", async (
            string project, string repoId, int prId,
            AdoContext ctx, ThreadStore threads, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();

            var thread = await threads.FindAsync(ctx.UserId!, project, repoId, prId, ct);
            if (thread is null)
                return Results.Ok(new ThreadDto(null, []));

            var turns = await threads.TurnsAsync(thread.Id, ct);
            return Results.Ok(new ThreadDto(thread.Id, turns.Select(ToTurnDto).ToList()));
        });
    }

    /// <summary>One turn as the panel renders it. Postability is decided here so the rule has one home.</summary>
    private static AgentTurnDto ToTurnDto(Data.AgentThreadTurn t) => new(
        t.Id,
        t.Ordinal,
        t.Question,
        t.Answer,
        t.Provenance,
        ThreadStore.Citations(t).Select(c => new CitationDto(c.Path, c.Line, c.EndLine)).ToList(),
        t.InferenceNote,
        t.Mode,
        t.ConnectorName,
        t.Model,
        t.CommitSha,
        t.Stopped,
        t.ErrorCode,
        ThreadStore.IsPostable(t),
        t.CreatedAt);

    /// <summary>
    /// Puts the response into streaming mode.
    ///
    /// <c>DisableBuffering</c> is the part that actually matters here: <c>X-Accel-Buffering</c> is
    /// an nginx convention and this app serves from Kestrel directly, so setting the header alone
    /// would leave the deltas batched — indistinguishable from a hang. The header is still sent for
    /// the day a proxy is introduced.
    /// </summary>
    private static void StartSse(HttpContext http)
    {
        http.Response.StatusCode = 200;
        http.Response.ContentType = "text/event-stream";
        http.Response.Headers.CacheControl = "no-cache";
        http.Response.Headers["X-Accel-Buffering"] = "no";
        http.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
    }

    private static async Task Send(HttpContext http, string @event, object payload, CancellationToken ct)
    {
        var text = $"event: {@event}\ndata: {JsonSerializer.Serialize(payload, Sse)}\n\n";
        await http.Response.WriteAsync(text, Encoding.UTF8, ct);
        // Flush per event, or the deltas arrive in one batch and the whole point of streaming is
        // lost. Verified by observation, never from configuration.
        await http.Response.Body.FlushAsync(ct);
    }

    private static void Record(Connector connector, AgentProbe probe)
    {
        if (probe.Ok)
        {
            connector.LastOkAt = DateTime.UtcNow;
            connector.LastErrorCode = null;
            connector.LastErrorAt = null;
        }
        else
        {
            connector.LastErrorCode = probe.Error?.Code.ToString().ToLowerInvariant();
            connector.LastErrorAt = DateTime.UtcNow;
        }
    }

    private static ProbeResultDto ToDto(AgentProbe probe) => new(
        probe.Ok,
        probe.LatencyMs,
        probe.Models,
        probe.Error?.Code.ToString().ToLowerInvariant(),
        probe.Error?.HttpStatus,
        probe.Error?.Detail,
        probe.Error?.RetryAfterSeconds);
}
