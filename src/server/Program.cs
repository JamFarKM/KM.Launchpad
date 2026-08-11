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

var app = builder.Build();

// Create schema on first boot (no migrations needed for v1).
using (var scope = app.Services.CreateScope())
    scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.EnsureCreated();

app.UseMiddleware<SessionMiddleware>();

app.MapApi();

// Serve the built React SPA and fall back to index.html for client routes.
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapFallbackToFile("index.html");

app.Run();
