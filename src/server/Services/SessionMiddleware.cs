using Microsoft.EntityFrameworkCore;
using PipelineLaunchpad.Server.Data;

namespace PipelineLaunchpad.Server.Services;

/// <summary>
/// Resolves the <c>pl_session</c> cookie to a user and hydrates <see cref="AdoContext"/>
/// with their org and decrypted PAT for the duration of the request.
/// </summary>
public class SessionMiddleware(RequestDelegate next)
{
    public const string CookieName = "pl_session";

    public async Task InvokeAsync(HttpContext http, AppDbContext db, AdoContext ctx, PatProtector protector)
    {
        if (http.Request.Cookies.TryGetValue(CookieName, out var token) && !string.IsNullOrEmpty(token))
        {
            var session = await db.Sessions.FirstOrDefaultAsync(s => s.Token == token);
            if (session is not null)
            {
                var user = await db.Users.FirstOrDefaultAsync(u => u.Id == session.UserId);
                if (user is not null)
                {
                    ctx.UserId = user.Id;
                    ctx.Org = user.Org;
                    try { ctx.Pat = protector.Unprotect(user.EncryptedPat); }
                    catch { /* key rotated / corrupt — treat as unauthenticated */ }

                    session.LastSeenAt = DateTime.UtcNow;
                    await db.SaveChangesAsync();
                }
            }
        }

        await next(http);
    }
}
