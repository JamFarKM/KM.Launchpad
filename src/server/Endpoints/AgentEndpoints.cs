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
            ThreadStore threads, AgentConversation conversation, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) { http.Response.StatusCode = 401; return; }

            if (string.IsNullOrWhiteSpace(body.Question))
            {
                http.Response.StatusCode = 400;
                await http.Response.WriteAsJsonAsync(new { error = "A question is required." }, ct);
                return;
            }

            // History comes from the thread, not the client. §7.5: Launchpad owns the conversation,
            // which is what keeps connectors stateless and lets the provider change mid-thread.
            var thread = await threads.GetOrCreateAsync(ctx.UserId!, project, repoId, prId, ct);

            await RunAskAsync(project, repoId, prId, body.Question, thread,
                http, ctx, db, registry, ado, contexts, threads, conversation, ct);
        });

        /* A follow-up scoped to one annotation (§7.6).
         *
         * The same machinery, and deliberately so: an annotation is a thread with an anchor, so the
         * only differences are which turns get replayed and a note telling the agent which line the
         * conversation is about. A second ask path would have been a second place for the budget, the
         * tool loop, the taxonomy and the "nothing posts itself" rule to drift. */
        api.MapPost("/review/{project}/{repoId}/pulls/{prId:int}/annotations/{annotationId}/ask", async (
            string project, string repoId, int prId, string annotationId, AskRequest body,
            HttpContext http, AdoContext ctx, AppDbContext db,
            AgentRegistry registry, AdoService ado, PrContextService contexts,
            ThreadStore threads, AgentConversation conversation, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) { http.Response.StatusCode = 401; return; }

            if (string.IsNullOrWhiteSpace(body.Question))
            {
                http.Response.StatusCode = 400;
                await http.Response.WriteAsJsonAsync(new { error = "A question is required." }, ct);
                return;
            }

            var annotation = await threads.FindAnnotationAsync(ctx.UserId!, annotationId, ct);
            if (annotation is null)
            {
                http.Response.StatusCode = 404;
                await http.Response.WriteAsJsonAsync(new { error = "That annotation no longer exists." }, ct);
                return;
            }

            await RunAskAsync(project, repoId, prId, body.Question, annotation,
                http, ctx, db, registry, ado, contexts, threads, conversation, ct);
        });

        // Every annotation on this pull request, for this reviewer — the gutter markers and the
        // dock's cycling control both read this.
        api.MapGet("/review/{project}/{repoId}/pulls/{prId:int}/annotations", async (
            string project, string repoId, int prId,
            AdoContext ctx, ThreadStore threads, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();

            var annotations = await threads.AnnotationsAsync(ctx.UserId!, project, repoId, prId, ct);
            var dtos = new List<AnnotationDto>(annotations.Count);
            foreach (var a in annotations)
                dtos.Add(ToAnnotationDto(a, await threads.TurnsAsync(a.Id, ct)));

            return Results.Ok(dtos);
        });

        // Opening a marker for the first time. Idempotent per line: two claims citing the same line
        // belong in one conversation about that spot, not in two cards fighting over one marker.
        api.MapPost("/review/{project}/{repoId}/pulls/{prId:int}/annotations", async (
            string project, string repoId, int prId, CreateAnnotationRequest body,
            AdoContext ctx, ThreadStore threads, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();
            if (string.IsNullOrWhiteSpace(body.Path) || body.Line <= 0)
                return Results.BadRequest(new { error = "A path and a line are required." });

            var annotation = await threads.GetOrCreateAnnotationAsync(
                ctx.UserId!, project, repoId, prId,
                body.Path, body.Line, body.EndLine, body.CommitSha, body.Seed, ct);

            return Results.Ok(ToAnnotationDto(annotation, await threads.TurnsAsync(annotation.Id, ct)));
        });

        // Resolve, or reopen. Never deletes: same "a record of what was asked survives" principle as
        // §7.5, and `Show resolved` brings a dimmed marker back into rotation.
        api.MapPost("/review/{project}/{repoId}/pulls/{prId:int}/annotations/{annotationId}/status", async (
            string annotationId, AnnotationStatusRequest body,
            AdoContext ctx, ThreadStore threads, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();

            var annotation = await threads.FindAnnotationAsync(ctx.UserId!, annotationId, ct);
            if (annotation is null) return Results.NotFound();

            await threads.SetStatusAsync(annotation, body.Status, ct);
            return Results.Ok(ToAnnotationDto(annotation, await threads.TurnsAsync(annotation.Id, ct)));
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

    /// <summary>
    /// One question, streamed, against one thread — the dock's conversation or an annotation's.
    ///
    /// Shared on purpose. The iteration budget, the tool loop, the §4 taxonomy, the recording of a
    /// stopped answer and the rule that nothing reaches the pull request by itself all live here once;
    /// a second copy for annotations would be four places for those to drift apart.
    /// </summary>
    private static async Task RunAskAsync(
        string project, string repoId, int prId, string question, Data.AgentThread thread,
        HttpContext http, AdoContext ctx, AppDbContext db,
        AgentRegistry registry, AdoService ado, PrContextService contexts,
        ThreadStore threads, AgentConversation conversation, CancellationToken ct)
    {
        {
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
                context = await contexts.BuildAsync(project, repoId, pr, question, ct);
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

            // This thread's own turns, never the main conversation's — an annotation is a separate
            // conversation about one line, and pouring the dock's history into it would answer the
            // wrong question.
            var history = await threads.ReplayAsync(thread.Id, ct);

            /* An annotation's anchor reaches the model as a prompt note rather than as a rewritten
               question, so the stored question stays what the reviewer actually typed and replay does
               not lose the scope on the second turn. The seed goes here too, rather than being
               replayed as a fabricated user turn — the agent said it, nobody asked it. */
            var prompt = TaskPrompt.Structured(context.Truncated);
            if (thread.Kind == AgentThreadKinds.Annotation)
                prompt += TaskPrompt.AnnotationScope(thread.Path ?? "", thread.Line ?? 0, thread.Seed);

            var request = new CanonicalRequest(
                SystemPrompt: prompt,
                Context: context.Xml,
                History: history,
                Question: question,
                Model: connector.Model ?? "",
                Stream: true,
                // Repository access. Empty would disable it without touching an adapter.
                Tools: RepoTools.Definitions);

            await Send(http, "turn", new { threadId = thread.Id, replayedTurns = history.Count }, ct);

            CanonicalAnswer? answer = null;
            AgentUsage? usage = null;
            AgentError? failure = null;
            var stopped = false;

            var budget = new AgentBudget();
            var scope = new RepoScope(project, repoId, pr.SourceCommit ?? "");
            var reads = new List<string>();
            // What a citation is allowed to name (§5.2). The changed files; the conversation adds
            // whatever the agent actually read to it, since a citation to a caller it looked up is a
            // legitimate answer rather than an invented path.
            var citablePaths = context.Paths;

            try
            {
                await foreach (var ev in conversation.RunAsync(
                    adapter, target, request, scope, budget, citablePaths, ct))
                {
                    switch (ev)
                    {
                        // The streaming unit (§5.2): a whole claim with its badge and its citations,
                        // rendered the moment it closes rather than a string growing a character at a
                        // time under a badge that can't be decided yet.
                        case ConversationEvent.Segment s:
                            await Send(http, "segment", ToSegmentDto(s.Value), ct);
                            break;

                        // Mode 3 only — prose from a connector that asserted nothing.
                        case ConversationEvent.Delta d:
                            await Send(http, "delta", new { text = d.Text }, ct);
                            break;

                        // Surfaced live so the reviewer sees the agent working rather than a silent
                        // pause, and so an answer's basis is visible afterwards.
                        case ConversationEvent.Reading r:
                            await Send(http, "reading", new { tool = r.Tool, detail = r.Detail }, ct);
                            break;

                        case ConversationEvent.Complete c:
                            answer = c.Answer;
                            usage = c.Usage;
                            reads = c.Reads.ToList();
                            break;

                        case ConversationEvent.Failed f:
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
                thread, question, answer, connector, pr.SourceCommit, usage,
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
        }
    }

    /// <summary>One annotation and its conversation (§7.6).</summary>
    private static AnnotationDto ToAnnotationDto(Data.AgentThread a, List<Data.AgentThreadTurn> turns) => new(
        a.Id,
        a.Path ?? "",
        a.Line ?? 0,
        a.EndLine,
        a.CommitSha,
        a.Seed,
        a.Status,
        turns.Select(ToTurnDto).ToList(),
        a.CreatedAt,
        a.UpdatedAt);

    /// <summary>One turn as the panel renders it. Postability is decided here so the rule has one home.</summary>
    private static AgentTurnDto ToTurnDto(Data.AgentThreadTurn t) => new(
        t.Id,
        t.Ordinal,
        t.Question,
        t.Answer,
        ThreadStore.Segments(t).Select(ToSegmentDto).ToList(),
        t.Mode,
        t.ConnectorName,
        t.Model,
        t.CommitSha,
        t.Stopped,
        t.ErrorCode,
        ThreadStore.IsPostable(t),
        t.CreatedAt);

    private static AgentSegmentDto ToSegmentDto(AnswerSegment s) => new(
        s.Text,
        s.Provenance is { } p ? ProvenanceNames.ToWire(p) : null,
        SeverityNames.ToWire(s.Severity),
        s.Citations.Select(c => new CitationDto(c.Path, c.Line, c.EndLine)).ToList(),
        s.InferenceNote);

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
