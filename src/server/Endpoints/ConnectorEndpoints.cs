using Microsoft.EntityFrameworkCore;
using PipelineLaunchpad.Server.Data;
using PipelineLaunchpad.Server.Models;
using PipelineLaunchpad.Server.Services;

namespace PipelineLaunchpad.Server.Endpoints;

/// <summary>
/// CRUD for the agents a user can talk to (DESIGN_SPEC_CONNECTORS.md §2.1).
///
/// No endpoint here returns credential material. The connection test and the completion routes
/// live with the adapters, since a test that cannot call a provider would be a button that lies.
/// </summary>
public static class ConnectorEndpoints
{
    public static void MapConnectors(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        // The picker grid's source of truth, so the four-card layout in §3.0 isn't duplicated in
        // TypeScript where it could drift from what the server will actually accept.
        api.MapGet("/connector-providers", (AdoContext ctx) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();
            return Results.Ok(ConnectorProviders.Selectable().Select(p => new ProviderDto(
                p.Key,
                p.DisplayName,
                p.Auth == ConnectorAuth.OAuth ? "oauth" : "api_key",
                p.FixedBaseUrl,
                p.CredentialLabel,
                UrlEditable: p.FixedBaseUrl is null && p.Auth == ConnectorAuth.ApiKey)).ToList());
        });

        api.MapGet("/connectors", async (AdoContext ctx, AppDbContext db, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();
            return Results.Ok(await ListAsync(db, ctx.UserId!, ct));
        });

        api.MapPost("/connectors", async (
            CreateConnectorRequest body, AdoContext ctx, AppDbContext db,
            ConnectorProtector protector, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();

            if (!ConnectorProviders.IsKnown(body.Provider))
                return Results.BadRequest(new { error = "Unknown provider." });

            var info = ConnectorProviders.Info(body.Provider);

            // §2.1: base_url and token are rejected for github_copilot — that provider exists only
            // once the OAuth routes complete, never via a POST carrying a secret. Rejecting rather
            // than ignoring, so a client built on the wrong assumption finds out immediately.
            if (info.Auth == ConnectorAuth.OAuth)
            {
                if (!string.IsNullOrWhiteSpace(body.Token) || !string.IsNullOrWhiteSpace(body.BaseUrl))
                    return Results.BadRequest(new
                    {
                        error = $"{info.DisplayName} connects through GitHub rather than a pasted credential. " +
                                "Start the OAuth flow instead of posting a token or a URL."
                    });

                return Results.BadRequest(new
                {
                    error = $"{info.DisplayName} isn't available yet — its adapter is pending a spike " +
                            "against a licensed account. Use Anthropic, OpenAI or a Custom endpoint."
                });
            }

            if (string.IsNullOrWhiteSpace(body.Token))
                return Results.BadRequest(new { error = $"A{(info.CredentialLabel.StartsWith('A') ? "n" : "")} {info.CredentialLabel.ToLowerInvariant()} is required." });

            var baseUrl = ConnectorProviders.ResolveBaseUrl(body.Provider, body.BaseUrl);
            if (baseUrl is null)
                return Results.BadRequest(new { error = "A base URL is required, e.g. https://host/v1" });

            // Only validate a URL the user actually supplied. A provider with a fixed host supplies
            // its own constant, and checking that would be both pointless and — for a non-http
            // scheme — wrong.
            if (info.FixedBaseUrl is null && !IsHttpUrl(baseUrl))
                return Results.BadRequest(new { error = "The base URL must be an absolute http or https URL." });

            var token = body.Token.Trim();
            var now = DateTime.UtcNow;
            var connector = new Connector
            {
                Id = Guid.NewGuid().ToString("N"),
                UserId = ctx.UserId!,
                Provider = body.Provider,
                Name = string.IsNullOrWhiteSpace(body.Name) ? info.DisplayName : body.Name.Trim(),
                BaseUrl = baseUrl,
                Model = string.IsNullOrWhiteSpace(body.Model) ? null : body.Model.Trim(),
                AuthType = ConnectorProviders.AuthTypeOf(body.Provider),
                TokenCiphertext = protector.ProtectApiKey(token),
                TokenLast4 = ConnectorProtector.Last4(token),
                TokenSetAt = now,
                CreatedAt = now,
            };

            db.Connectors.Add(connector);
            await AssignCapabilitiesAsync(db, ctx.UserId!, connector.Id, body.Capabilities, ct);
            await db.SaveChangesAsync(ct);

            return Results.Ok((await ListAsync(db, ctx.UserId!, ct)).First(c => c.Id == connector.Id));
        });

        api.MapPatch("/connectors/{id}", async (
            string id, PatchConnectorRequest body, AdoContext ctx, AppDbContext db,
            ConnectorProtector protector, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();

            var connector = await db.Connectors
                .FirstOrDefaultAsync(c => c.Id == id && c.UserId == ctx.UserId, ct);
            if (connector is null) return Results.NotFound();

            var info = ConnectorProviders.Info(connector.Provider);

            if (body.Name is not null && body.Name.Trim().Length > 0)
                connector.Name = body.Name.Trim();

            if (body.Model is not null)
                connector.Model = body.Model.Trim().Length == 0 ? null : body.Model.Trim();

            // Only Custom has a host the reviewer owns; for the pinned providers the stored value
            // stays whatever the provider constant says, so an adapter never has to reconcile the two.
            if (body.BaseUrl is not null && info.FixedBaseUrl is null && info.Auth == ConnectorAuth.ApiKey)
            {
                var next = ConnectorProviders.ResolveBaseUrl(connector.Provider, body.BaseUrl);
                if (next is null)
                    return Results.BadRequest(new { error = "A base URL is required, e.g. https://host/v1" });
                if (!IsHttpUrl(next))
                    return Results.BadRequest(new { error = "The base URL must be an absolute http or https URL." });

                // A changed host invalidates what we know about reachability: the old green tick
                // described a different service. Back to "not tested" rather than inheriting it.
                if (next != connector.BaseUrl)
                {
                    connector.BaseUrl = next;
                    connector.LastOkAt = null;
                    connector.LastErrorCode = null;
                    connector.LastErrorAt = null;
                }
            }

            // Absent means "leave the stored credential alone"; a non-empty value replaces it.
            // An explicitly empty string is a clear enough mistake to reject rather than to
            // interpret, since interpreting it either way silently loses a working credential.
            if (body.Token is not null)
            {
                var token = body.Token.Trim();
                if (token.Length == 0)
                    return Results.BadRequest(new { error = "Leave the credential out to keep the stored one, or send a new value to replace it." });

                connector.TokenCiphertext = protector.ProtectApiKey(token);
                connector.TokenLast4 = ConnectorProtector.Last4(token);
                connector.TokenSetAt = DateTime.UtcNow;
                connector.LastOkAt = null;
                connector.LastErrorCode = null;
                connector.LastErrorAt = null;
            }

            if (body.Capabilities is not null)
                await AssignCapabilitiesAsync(db, ctx.UserId!, connector.Id, body.Capabilities, ct);

            await db.SaveChangesAsync(ct);
            return Results.Ok((await ListAsync(db, ctx.UserId!, ct)).First(c => c.Id == connector.Id));
        });

        api.MapDelete("/connectors/{id}", async (string id, AdoContext ctx, AppDbContext db, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();

            var connector = await db.Connectors
                .FirstOrDefaultAsync(c => c.Id == id && c.UserId == ctx.UserId, ct);
            if (connector is null) return Results.NotFound();

            // Deleting takes the stored credential and the capability assignments with it (§2).
            // Conversation history is deliberately untouched — §7.5: a thread is a record of what
            // the reviewer asked, and it outlives the agent that answered.
            var held = await db.ConnectorCapabilities
                .Where(c => c.ConnectorId == connector.Id)
                .ToListAsync(ct);
            db.ConnectorCapabilities.RemoveRange(held);
            db.Connectors.Remove(connector);
            await db.SaveChangesAsync(ct);

            return Results.NoContent();
        });
    }

    /// <summary>A URL we can actually make a request to — the only kind worth storing.</summary>
    private static bool IsHttpUrl(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var parsed)
        && (parsed.Scheme == Uri.UriSchemeHttp || parsed.Scheme == Uri.UriSchemeHttps);

    /// <summary>
    /// Moves each named capability to this connector, taking it from whichever one held it.
    ///
    /// The composite primary key means there is nothing to delete first: the upsert *is* the
    /// transfer, and it cannot half-happen. §2 requires it be atomic across providers, which falls
    /// out of doing it in the caller's transaction rather than needing care.
    /// </summary>
    private static async Task AssignCapabilitiesAsync(
        AppDbContext db, string userId, string connectorId, List<string>? capabilities, CancellationToken ct)
    {
        if (capabilities is null) return;

        var wanted = capabilities
            .Where(c => c == ConnectorProviders.PrQuestions)
            .Distinct()
            .ToList();

        var existing = await db.ConnectorCapabilities
            .Where(c => c.UserId == userId)
            .ToListAsync(ct);

        foreach (var capability in wanted)
        {
            var row = existing.FirstOrDefault(c => c.Capability == capability);
            if (row is null)
            {
                db.ConnectorCapabilities.Add(new ConnectorCapability
                {
                    UserId = userId,
                    Capability = capability,
                    ConnectorId = connectorId,
                    AssignedAt = DateTime.UtcNow,
                });
            }
            else if (row.ConnectorId != connectorId)
            {
                row.ConnectorId = connectorId;
                row.AssignedAt = DateTime.UtcNow;
            }
        }

        // Capabilities this connector holds but the caller didn't list are being given up. There
        // is no "assigned to nobody but connectors exist" state the UI hides — §2 says the Review
        // panel shows Not connected, so the row simply goes.
        foreach (var row in existing.Where(c => c.ConnectorId == connectorId && !wanted.Contains(c.Capability)))
            db.ConnectorCapabilities.Remove(row);
    }

    private static async Task<List<ConnectorDto>> ListAsync(AppDbContext db, string userId, CancellationToken ct)
    {
        var connectors = await db.Connectors
            .Where(c => c.UserId == userId)
            .OrderBy(c => c.CreatedAt)
            .ToListAsync(ct);

        var capabilities = await db.ConnectorCapabilities
            .Where(c => c.UserId == userId)
            .ToListAsync(ct);

        return connectors.Select(c => new ConnectorDto(
            c.Id,
            c.Provider,
            c.Name,
            c.BaseUrl,
            c.Model,
            c.AuthType,
            c.TokenLast4,
            c.TokenSetAt,
            c.OauthLogin,
            c.OauthScope,
            StatusOf(c),
            c.LastOkAt,
            c.LastErrorCode,
            c.LastErrorAt,
            capabilities.Where(k => k.ConnectorId == c.Id).Select(k => k.Capability).ToList()
        )).ToList();
    }

    /// <summary>
    /// The four states in §3.1, each of which gets its own shape in the UI per A4.
    ///
    /// Ordered so the most specific wins: an OAuth grant that hasn't completed is "connecting"
    /// even though it has never succeeded either, because "not tested" would suggest an action the
    /// reviewer doesn't have — the flow completes itself.
    /// </summary>
    private static string StatusOf(Connector c)
    {
        if (c.AuthType == "oauth" && c.OauthLogin is null) return "connecting";
        if (c.LastOkAt is null) return "not_tested";
        if (c.LastErrorAt is not null && c.LastErrorAt > c.LastOkAt) return "unreachable";
        return "connected";
    }
}
