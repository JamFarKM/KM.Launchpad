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
builder.Services.AddSingleton<ConnectorProtector>();

// --- agent connectors ---
// Infinite HttpClient timeout on purpose: it applies to the whole operation including reading the
// body, so any finite value would kill a legitimately long stream. The §5.5 budget is enforced
// per-phase inside the adapters instead.
builder.Services.AddHttpClient("agent", c => c.Timeout = Timeout.InfiniteTimeSpan);
builder.Services.AddSingleton<PipelineLaunchpad.Server.Services.Agents.IAgentAdapter, PipelineLaunchpad.Server.Services.Agents.AnthropicAdapter>();
// One class, two providers: OpenAI is 5.A with the host pinned, not a separate contract.
builder.Services.AddSingleton<PipelineLaunchpad.Server.Services.Agents.IAgentAdapter>(sp =>
    new PipelineLaunchpad.Server.Services.Agents.OpenAiCompatibleAdapter(
        sp.GetRequiredService<IHttpClientFactory>(), PipelineLaunchpad.Server.Services.ConnectorProviders.Custom));
builder.Services.AddSingleton<PipelineLaunchpad.Server.Services.Agents.IAgentAdapter>(sp =>
    new PipelineLaunchpad.Server.Services.Agents.OpenAiCompatibleAdapter(
        sp.GetRequiredService<IHttpClientFactory>(), PipelineLaunchpad.Server.Services.ConnectorProviders.OpenAi));
// The stub is registered but not selectable (ConnectorProviders.Selectable omits it), so the SSE
// relay and the panel states can be exercised without a real provider or a real credential.
builder.Services.AddSingleton<PipelineLaunchpad.Server.Services.Agents.IAgentAdapter>(
    _ => new PipelineLaunchpad.Server.Services.Agents.StubAdapter(TimeSpan.FromMilliseconds(60)));
builder.Services.AddSingleton<PipelineLaunchpad.Server.Services.Agents.AgentRegistry>();

// --- Azure DevOps access ---
builder.Services.AddHttpClient("ado", c => c.Timeout = TimeSpan.FromSeconds(60));
builder.Services.AddScoped<AdoContext>();
builder.Services.AddScoped<AdoService>();
builder.Services.AddScoped<ConfigService>();
builder.Services.AddScoped<PipelineLaunchpad.Server.Services.Agents.PrContextService>();
builder.Services.AddScoped<PipelineLaunchpad.Server.Services.Agents.ThreadStore>();
builder.Services.AddScoped<PipelineLaunchpad.Server.Services.Agents.RepoTools>();
builder.Services.AddScoped<PipelineLaunchpad.Server.Services.Agents.AgentConversation>();
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

        -- Connectors (DESIGN_SPEC_CONNECTORS.md §2). Ciphertext columns are TEXT, not BLOB:
        -- Data Protection's Protect() returns a base64url string and every other secret in this
        -- app is stored the same way, so a BLOB here would be a second convention for no gain.
        CREATE TABLE IF NOT EXISTS "Connectors" (
            "Id" TEXT NOT NULL CONSTRAINT "PK_Connectors" PRIMARY KEY,
            "UserId" TEXT NOT NULL,
            "Provider" TEXT NOT NULL,
            "Name" TEXT NOT NULL,
            "BaseUrl" TEXT NULL,
            "Model" TEXT NULL,
            "AuthType" TEXT NOT NULL,
            "TokenCiphertext" TEXT NULL,
            "TokenLast4" TEXT NULL,
            "TokenSetAt" TEXT NULL,
            "OauthLogin" TEXT NULL,
            "OauthAccessCiphertext" TEXT NULL,
            "OauthRefreshCiphertext" TEXT NULL,
            "OauthScope" TEXT NULL,
            "OauthExpiresAt" TEXT NULL,
            "LastOkAt" TEXT NULL,
            "LastErrorCode" TEXT NULL,
            "LastErrorAt" TEXT NULL,
            "CreatedAt" TEXT NOT NULL,
            -- §2: "a row with both, or neither, is invalid — enforce with a check constraint, not
            -- just application code". A half-written credential is the kind of state that becomes
            -- a support ticket about an agent that authenticates only sometimes.
            CONSTRAINT "CK_Connectors_OneCredentialShape" CHECK (
                ("AuthType" = 'api_key' AND "OauthAccessCiphertext" IS NULL AND "OauthRefreshCiphertext" IS NULL)
             OR ("AuthType" = 'oauth'   AND "TokenCiphertext" IS NULL)
            )
        );
        CREATE INDEX IF NOT EXISTS "IX_Connectors_UserId" ON "Connectors" ("UserId");

        -- One row per user per capability, so "two connectors answer PR questions" is
        -- unrepresentable: assigning is an upsert and §2's transfer is atomic for free.
        CREATE TABLE IF NOT EXISTS "ConnectorCapabilities" (
            "UserId" TEXT NOT NULL,
            "Capability" TEXT NOT NULL,
            "ConnectorId" TEXT NOT NULL,
            "AssignedAt" TEXT NOT NULL,
            CONSTRAINT "PK_ConnectorCapabilities" PRIMARY KEY ("UserId", "Capability"),
            CONSTRAINT "FK_ConnectorCapabilities_Connectors" FOREIGN KEY ("ConnectorId")
                REFERENCES "Connectors" ("Id") ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS "IX_ConnectorCapabilities_ConnectorId"
            ON "ConnectorCapabilities" ("ConnectorId");

        -- Conversations (7.5). Owned by Launchpad, not by a connector, which is what keeps
        -- connectors stateless and lets a thread survive swapping the provider underneath it.
        CREATE TABLE IF NOT EXISTS "AgentThreads" (
            "Id" TEXT NOT NULL CONSTRAINT "PK_AgentThreads" PRIMARY KEY,
            "UserId" TEXT NOT NULL,
            "Project" TEXT NOT NULL,
            "RepoId" TEXT NOT NULL,
            "PullRequestId" INTEGER NOT NULL,
            "CreatedAt" TEXT NOT NULL,
            "UpdatedAt" TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS "IX_AgentThreads_Owner"
            ON "AgentThreads" ("UserId", "Project", "RepoId", "PullRequestId");

        -- No foreign key to Connectors, deliberately: a cascade there would delete a reviewer's
        -- history as a side effect of changing agents. ConnectorName is denormalised so the
        -- via-the-connector attribution in 7.4 still renders once the connector is gone.
        -- NB: no curly braces anywhere in this string, including comments. ExecuteSqlRaw parses it
        -- for zero-indexed placeholders written in curly braces, so a brace anywhere in here --
        -- even inside a comment -- crashes the app at startup.
        CREATE TABLE IF NOT EXISTS "AgentThreadTurns" (
            "Id" TEXT NOT NULL CONSTRAINT "PK_AgentThreadTurns" PRIMARY KEY,
            "ThreadId" TEXT NOT NULL,
            "Ordinal" INTEGER NOT NULL,
            "Question" TEXT NOT NULL,
            "Answer" TEXT NOT NULL,
            "SegmentsJson" TEXT NULL,
            "Provenance" TEXT NULL,
            "CitationsJson" TEXT NOT NULL DEFAULT '[]',
            "InferenceNote" TEXT NULL,
            "Mode" TEXT NOT NULL DEFAULT 'structured',
            "ConnectorId" TEXT NULL,
            "ConnectorName" TEXT NULL,
            "Model" TEXT NULL,
            "CommitSha" TEXT NULL,
            "PromptTokens" INTEGER NULL,
            "CompletionTokens" INTEGER NULL,
            "Stopped" INTEGER NOT NULL DEFAULT 0,
            "ErrorCode" TEXT NULL,
            "CreatedAt" TEXT NOT NULL,
            CONSTRAINT "FK_AgentThreadTurns_AgentThreads" FOREIGN KEY ("ThreadId")
                REFERENCES "AgentThreads" ("Id") ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS "IX_AgentThreadTurns_ThreadId"
            ON "AgentThreadTurns" ("ThreadId");
        """);

    /* Columns added to a table that already existed. CREATE TABLE IF NOT EXISTS is a no-op on an
       existing table, so an existing database never sees a new column from the statements above —
       and SQLite has no ADD COLUMN IF NOT EXISTS, so the check has to be explicit.

       SegmentsJson: the canonical answer became a list of segments rather than one string. Turns
       written before that keep their Answer/Provenance/CitationsJson and are read back as a single
       synthesised segment (see ThreadStore.Segments), so an existing thread stays readable rather
       than being migrated or discarded. */
    AddColumnIfMissing("AgentThreadTurns", "SegmentsJson", "TEXT NULL");

    void AddColumnIfMissing(string table, string column, string declaration)
    {
        var conn = db.Database.GetDbConnection();
        if (conn.State != System.Data.ConnectionState.Open) conn.Open();

        using var check = conn.CreateCommand();
        check.CommandText = $"SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = '{column}'";
        if (Convert.ToInt64(check.ExecuteScalar() ?? 0L) > 0) return;

        using var alter = conn.CreateCommand();
        alter.CommandText = $"ALTER TABLE \"{table}\" ADD COLUMN \"{column}\" {declaration}";
        alter.ExecuteNonQuery();
    }

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
app.MapConnectors();
app.MapAgents();

// Serve the built React SPA and fall back to index.html for client routes.
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapFallbackToFile("index.html");

app.Run();
