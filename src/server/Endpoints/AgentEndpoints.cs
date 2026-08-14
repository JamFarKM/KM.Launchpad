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
            AgentRegistry registry, AdoService ado, PrContextService contexts, CancellationToken ct) =>
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
            try
            {
                var pulls = await ado.GetPullRequestsAsync(project, repoId, "all", 200, ct);
                var pr = pulls.FirstOrDefault(p => p.Id == prId);
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

            var request = new CanonicalRequest(
                SystemPrompt: TaskPrompt.Structured(context.Truncated),
                Context: context.Xml,
                History: (body.History ?? []).Select(h => new AgentTurn(h.Question, h.Answer)).ToList(),
                Question: body.Question,
                Model: connector.Model ?? "",
                Stream: true);

            var failed = false;
            await foreach (var ev in adapter.CompleteAsync(target, request, ct))
            {
                switch (ev)
                {
                    case AgentEvent.Delta d:
                        await Send(http, "delta", new { text = d.Text }, ct);
                        break;

                    case AgentEvent.Complete c:
                        await Send(http, "complete", new
                        {
                            answer = c.Answer.Answer,
                            provenance = c.Answer.Provenance is { } p ? ProvenanceNames.ToWire(p) : null,
                            citations = c.Answer.Citations.Select(x => new { x.Path, x.Line, x.EndLine }),
                            inferenceNote = c.Answer.InferenceNote,
                            mode = c.Answer.Mode.ToString().ToLowerInvariant(),
                            // Mode 3 and failures are not postable as a PR comment (§7.4). Decided
                            // here rather than in the panel, so the rule has one home.
                            postable = c.Answer.Mode != StructuredMode.Unverified,
                        }, ct);
                        break;

                    case AgentEvent.Failed f:
                        failed = true;
                        await Send(http, "error", new
                        {
                            code = f.Error.Code.ToString().ToLowerInvariant(),
                            httpStatus = f.Error.HttpStatus,
                            detail = f.Error.Detail,
                            retryAfter = f.Error.RetryAfterSeconds,
                        }, ct);
                        break;
                }
            }

            // Record the outcome so Settings shows what the panel just experienced, rather than the
            // two disagreeing about whether the agent is reachable.
            connector.LastOkAt = failed ? connector.LastOkAt : DateTime.UtcNow;
            if (failed) connector.LastErrorAt = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
        });
    }

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
