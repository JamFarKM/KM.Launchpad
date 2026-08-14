using Microsoft.EntityFrameworkCore;

namespace PipelineLaunchpad.Server.Data;

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<AppUser> Users => Set<AppUser>();
    public DbSet<Session> Sessions => Set<Session>();
    public DbSet<SavedView> Views => Set<SavedView>();
    public DbSet<Sequence> Sequences => Set<Sequence>();
    public DbSet<SequenceRun> SequenceRuns => Set<SequenceRun>();
    public DbSet<ConfigRegistry> ConfigRegistries => Set<ConfigRegistry>();
    public DbSet<VaultRegistry> VaultRegistries => Set<VaultRegistry>();
    public DbSet<AzureCredential> AzureCredentials => Set<AzureCredential>();
    public DbSet<RepoFavourite> RepoFavourites => Set<RepoFavourite>();
    public DbSet<Connector> Connectors => Set<Connector>();
    public DbSet<ConnectorCapability> ConnectorCapabilities => Set<ConnectorCapability>();
    public DbSet<AgentThread> AgentThreads => Set<AgentThread>();
    public DbSet<AgentThreadTurn> AgentThreadTurns => Set<AgentThreadTurn>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<AppUser>().HasKey(u => u.Id);
        b.Entity<AppUser>()
            .HasMany(u => u.Views)
            .WithOne()
            .HasForeignKey(v => v.UserId)
            .OnDelete(DeleteBehavior.Cascade);

        b.Entity<Session>().HasKey(s => s.Token);
        b.Entity<Session>().HasIndex(s => s.UserId);

        b.Entity<SavedView>().HasKey(v => v.Id);
        b.Entity<SavedView>().HasIndex(v => v.UserId);

        b.Entity<Sequence>().HasKey(s => s.Id);
        b.Entity<Sequence>().HasIndex(s => s.UserId);

        b.Entity<SequenceRun>().HasKey(r => r.Id);
        b.Entity<SequenceRun>().HasIndex(r => r.SequenceId);

        b.Entity<ConfigRegistry>().HasKey(c => c.Id);
        b.Entity<ConfigRegistry>().HasIndex(c => c.UserId);

        b.Entity<VaultRegistry>().HasKey(v => v.Id);
        b.Entity<VaultRegistry>().HasIndex(v => v.UserId);

        b.Entity<AzureCredential>().HasKey(c => c.UserId);

        b.Entity<RepoFavourite>().HasKey(f => f.Id);
        b.Entity<RepoFavourite>().HasIndex(f => f.UserId);

        b.Entity<Connector>().HasKey(c => c.Id);
        b.Entity<Connector>().HasIndex(c => c.UserId);

        // The composite key IS the exclusivity rule from §2 — one connector per capability per
        // user, enforced by the schema rather than by whichever code path happens to assign it.
        b.Entity<ConnectorCapability>().HasKey(c => new { c.UserId, c.Capability });
        b.Entity<ConnectorCapability>().HasIndex(c => c.ConnectorId);

        // The relationship has to be declared here as well as in the DDL. Without it EF has no
        // idea the capability row depends on the connector row, so it picks its own INSERT order
        // and half the time writes the child first — which the database then rejects. A foreign
        // key that exists only in raw SQL fails at runtime rather than at build.
        b.Entity<ConnectorCapability>()
            .HasOne<Connector>()
            .WithMany()
            .HasForeignKey(c => c.ConnectorId)
            .OnDelete(DeleteBehavior.Cascade);

        b.Entity<AgentThread>().HasKey(t => t.Id);
        b.Entity<AgentThread>().HasIndex(t => new { t.UserId, t.Project, t.RepoId, t.PullRequestId });

        b.Entity<AgentThreadTurn>().HasKey(t => t.Id);
        b.Entity<AgentThreadTurn>().HasIndex(t => t.ThreadId);
        // Turns cascade from their thread but NOT from a connector: 7.5 keeps a reviewer's
        // history when the agent that answered is removed or swapped.
        b.Entity<AgentThreadTurn>()
            .HasOne<AgentThread>()
            .WithMany()
            .HasForeignKey(t => t.ThreadId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
