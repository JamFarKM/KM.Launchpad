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
    }
}
