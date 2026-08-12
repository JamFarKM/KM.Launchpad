using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using PipelineLaunchpad.Server.Data;
using PipelineLaunchpad.Server.Endpoints;
using PipelineLaunchpad.Server.Models;
using PipelineLaunchpad.Server.Services;

var builder = WebApplication.CreateBuilder(args);

// Environment overrides (Docker) win over appsettings.
builder.Configuration.AddEnvironmentVariables();

// Persisted state directory (SQLite db + Data Protection keys). The local default is
// ".pl-data" (not "data") so it never collides with the source folder src/server/Data
// on case-insensitive filesystems. In Docker, PL_DATA_DIR=/data (a mounted volume).
var dataDir = builder.Configuration["PL_DATA_DIR"]
    ?? Path.Combine(builder.Environment.ContentRootPath, ".pl-data");
Directory.CreateDirectory(dataDir);

// --- persistence ---
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlite($"Data Source={Path.Combine(dataDir, "launchpad.db")}"));

// --- PAT-at-rest encryption ---
builder.Services.AddDataProtection()
    .PersistKeysToFileSystem(new DirectoryInfo(Path.Combine(dataDir, "keys")))
    .SetApplicationName("PipelineLaunchpad");
builder.Services.AddSingleton<PatProtector>();

// --- Azure DevOps access ---
builder.Services.AddHttpClient("ado", c => c.Timeout = TimeSpan.FromSeconds(60));
builder.Services.AddScoped<AdoContext>();
builder.Services.AddScoped<AdoService>();
builder.Services.AddScoped<ConfigService>();
builder.Services.AddSingleton<ConfigStoreService>();
builder.Services.AddSingleton<VaultStoreService>();
builder.Services.AddSingleton<SequenceRunner>();

var app = builder.Build();

// Create schema on first boot, then additively create any tables added after the
// database already existed (EnsureCreated is a no-op on an existing DB, so new
// entities' tables must be created explicitly — this preserves existing data).
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.EnsureCreated();
    db.Database.ExecuteSqlRaw("""
        CREATE TABLE IF NOT EXISTS "Sequences" (
            "Id" TEXT NOT NULL CONSTRAINT "PK_Sequences" PRIMARY KEY,
            "UserId" TEXT NOT NULL,
            "Name" TEXT NOT NULL,
            "StepsJson" TEXT NOT NULL,
            "CreatedAt" TEXT NOT NULL,
            "UpdatedAt" TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS "IX_Sequences_UserId" ON "Sequences" ("UserId");

        CREATE TABLE IF NOT EXISTS "SequenceRuns" (
            "Id" TEXT NOT NULL CONSTRAINT "PK_SequenceRuns" PRIMARY KEY,
            "SequenceId" TEXT NOT NULL,
            "UserId" TEXT NOT NULL,
            "Status" TEXT NOT NULL,
            "StepsJson" TEXT NOT NULL,
            "StartedAt" TEXT NOT NULL,
            "FinishedAt" TEXT NULL
        );
        CREATE INDEX IF NOT EXISTS "IX_SequenceRuns_SequenceId" ON "SequenceRuns" ("SequenceId");

        CREATE TABLE IF NOT EXISTS "ConfigRegistries" (
            "Id" TEXT NOT NULL CONSTRAINT "PK_ConfigRegistries" PRIMARY KEY,
            "UserId" TEXT NOT NULL,
            "Name" TEXT NOT NULL,
            "Secret" TEXT NOT NULL,
            "CreatedAt" TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS "IX_ConfigRegistries_UserId" ON "ConfigRegistries" ("UserId");

        CREATE TABLE IF NOT EXISTS "VaultRegistries" (
            "Id" TEXT NOT NULL CONSTRAINT "PK_VaultRegistries" PRIMARY KEY,
            "UserId" TEXT NOT NULL,
            "Name" TEXT NOT NULL,
            "Secret" TEXT NOT NULL,
            "CreatedAt" TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS "IX_VaultRegistries_UserId" ON "VaultRegistries" ("UserId");

        CREATE TABLE IF NOT EXISTS "AzureCredentials" (
            "UserId" TEXT NOT NULL CONSTRAINT "PK_AzureCredentials" PRIMARY KEY,
            "Secret" TEXT NOT NULL,
            "UpdatedAt" TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS "RepoFavourites" (
            "Id" TEXT NOT NULL CONSTRAINT "PK_RepoFavourites" PRIMARY KEY,
            "UserId" TEXT NOT NULL,
            "Project" TEXT NOT NULL,
            "RepoId" TEXT NOT NULL,
            "RepoName" TEXT NOT NULL,
            "SortOrder" INTEGER NOT NULL DEFAULT 0,
            "CreatedAt" TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS "IX_RepoFavourites_UserId" ON "RepoFavourites" ("UserId");
        """);

    // Any sequence run still "running" was orphaned by a previous process (restart/crash)
    // and can never resume — fail it so it doesn't hang forever as "in progress".
    var web = new JsonSerializerOptions(JsonSerializerDefaults.Web);
    var orphaned = db.SequenceRuns.Where(r => r.Status == "running").ToList();
    foreach (var run in orphaned)
    {
        var steps = JsonSerializer.Deserialize<List<SequenceRunStepDto>>(run.StepsJson, web) ?? new();
        for (var i = 0; i < steps.Count; i++)
        {
            var s = steps[i];
            if (s.State is "running" or "inProgress" or "notStarted")
                steps[i] = s with { State = "completed", Result = "failed", Message = "Interrupted by a server restart.", FinishedAt = DateTime.UtcNow };
            else if (s.State == "pending")
                steps[i] = s with { State = "skipped" };
        }
        run.StepsJson = JsonSerializer.Serialize(steps, web);
        run.Status = "failed";
        run.FinishedAt = DateTime.UtcNow;
    }
    if (orphaned.Count > 0) db.SaveChanges();
}

app.UseMiddleware<SessionMiddleware>();

app.MapApi();
app.MapSequences();
app.MapImportExport();
app.MapConfigRegistries();
app.MapVaultRegistries();

// Serve the built React SPA and fall back to index.html for client routes.
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapFallbackToFile("index.html");

app.Run();
