namespace PipelineLaunchpad.Server.Data;

/// <summary>A person who has connected with an Azure DevOps PAT.</summary>
public class AppUser
{
    /// <summary>Azure DevOps identity id (stable GUID from connectionData).</summary>
    public string Id { get; set; } = default!;
    public string DisplayName { get; set; } = "";
    public string UniqueName { get; set; } = "";
    public string Org { get; set; } = "";

    /// <summary>PAT encrypted via ASP.NET Data Protection. Never leaves the server.</summary>
    public string EncryptedPat { get; set; } = "";

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }

    public List<SavedView> Views { get; set; } = new();
}

/// <summary>An opaque server session mapping a cookie to a user.</summary>
public class Session
{
    public string Token { get; set; } = default!;
    public string UserId { get; set; } = default!;
    public DateTime CreatedAt { get; set; }
    public DateTime LastSeenAt { get; set; }
}

/// <summary>A user's Azure service principal, used to auth to Key Vault + endpoint-URL config stores.</summary>
public class AzureCredential
{
    public string UserId { get; set; } = default!;
    /// <summary>Encrypted JSON { tenantId, clientId, clientSecret }. Never returned to the client.</summary>
    public string Secret { get; set; } = "";
    public DateTime UpdatedAt { get; set; }
}

/// <summary>An Azure App Configuration store the user has registered to browse.</summary>
public class ConfigRegistry
{
    public string Id { get; set; } = default!;
    public string UserId { get; set; } = default!;
    public string Name { get; set; } = "";

    /// <summary>Encrypted connection string or endpoint URL (AAD). Never returned to the client.</summary>
    public string Secret { get; set; } = "";

    public DateTime CreatedAt { get; set; }
}

/// <summary>An Azure Key Vault the user has registered to browse secrets in.</summary>
public class VaultRegistry
{
    public string Id { get; set; } = default!;
    public string UserId { get; set; } = default!;
    public string Name { get; set; } = "";

    /// <summary>Encrypted vault URI. Never returned to the client.</summary>
    public string Secret { get; set; } = "";

    public DateTime CreatedAt { get; set; }
}

/// <summary>A user-defined chain of pipelines run in sequence (build → deploy → …).</summary>
public class Sequence
{
    public string Id { get; set; } = default!;
    public string UserId { get; set; } = default!;
    public string Name { get; set; } = "";

    /// <summary>JSON array of SequenceStepDto.</summary>
    public string StepsJson { get; set; } = "[]";

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}

/// <summary>A single execution of a <see cref="Sequence"/>, tracked server-side.</summary>
public class SequenceRun
{
    public string Id { get; set; } = default!;
    public string SequenceId { get; set; } = default!;
    public string UserId { get; set; } = default!;

    /// <summary>running | succeeded | failed | canceled.</summary>
    public string Status { get; set; } = "running";

    /// <summary>JSON array of SequenceRunStepDto (per-step live state).</summary>
    public string StepsJson { get; set; } = "[]";

    public DateTime StartedAt { get; set; }
    public DateTime? FinishedAt { get; set; }
}

/// <summary>A user-composed dashboard: an ordered set of pipeline references.</summary>
public class SavedView
{
    public string Id { get; set; } = default!;
    public string UserId { get; set; } = default!;
    public string Name { get; set; } = "";
    public int SortOrder { get; set; }

    /// <summary>JSON array of ViewItem — the pipelines the user pinned to this view.</summary>
    public string ItemsJson { get; set; } = "[]";

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}
