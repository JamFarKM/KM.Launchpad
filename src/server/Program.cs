using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using PipelineLaunchpad.Server.Data;
using PipelineLaunchpad.Server.Endpoints;
using PipelineLaunchpad.Server.Services;

var builder = WebApplication.CreateBuilder(args);

// Environment overrides (Docker) win over appsettings.
builder.Configuration.AddEnvironmentVariables();

// Persisted state directory (SQLite db + Data Protection keys).
var dataDir = builder.Configuration["PL_DATA_DIR"]
    ?? Path.Combine(builder.Environment.ContentRootPath, "data");
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

        CREATE TABLE IF NOT EXISTS "AzureCredentials" (
            "UserId" TEXT NOT NULL CONSTRAINT "PK_AzureCredentials" PRIMARY KEY,
            "Secret" TEXT NOT NULL,
            "UpdatedAt" TEXT NOT NULL
        );
        """);
}

app.UseMiddleware<SessionMiddleware>();

app.MapApi();
app.MapSequences();
app.MapImportExport();
app.MapConfigRegistries();

// Serve the built React SPA and fall back to index.html for client routes.
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapFallbackToFile("index.html");

app.Run();
