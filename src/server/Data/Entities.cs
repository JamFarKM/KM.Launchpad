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

/// <summary>A starred project+repository, surfaced as a quick link on the Review page.</summary>
public class RepoFavourite
{
    public string Id { get; set; } = default!;
    public string UserId { get; set; } = default!;
    public string Project { get; set; } = "";
    public string RepoId { get; set; } = "";
    public string RepoName { get; set; } = "";
    public int SortOrder { get; set; }
    public DateTime CreatedAt { get; set; }
}

/// <summary>
/// An agent the user can talk to — an instance of a provider (DESIGN_SPEC_CONNECTORS.md §2).
///
/// Never shared between users: each reviewer registers their own credential, so questions and
/// cost attribute to a person rather than to a service identity. <c>Provider</c> is the column
/// that drives everything else — which fields apply, which adapter handles requests, and which
/// credential shape the editor shows.
/// </summary>
public class Connector
{
    public string Id { get; set; } = default!;
    public string UserId { get; set; } = default!;

    /// <summary>anthropic | openai | github_copilot | custom.</summary>
    public string Provider { get; set; } = "";

    /// <summary>Display only, free text, mutable. Need not match the provider or the model.</summary>
    public string Name { get; set; } = "";

    /// <summary>
    /// Fixed per provider for anthropic/openai, editable for custom, null for github_copilot —
    /// which has no URL concept from the user's side.
    /// </summary>
    public string? BaseUrl { get; set; }

    /// <summary>Must be a value the provider's adapter reports as available.</summary>
    public string? Model { get; set; }

    /// <summary>api_key | oauth. Derived from Provider, stored for query convenience.</summary>
    public string AuthType { get; set; } = "api_key";

    /// <summary>
    /// api_key connectors only. Data Protection ciphertext — never egresses to a client, under
    /// any flag, including for the owner.
    /// </summary>
    public string? TokenCiphertext { get; set; }

    /// <summary>The only part of the credential the UI ever sees.</summary>
    public string? TokenLast4 { get; set; }
    public DateTime? TokenSetAt { get; set; }

    /// <summary>oauth connectors only: the linked GitHub username.</summary>
    public string? OauthLogin { get; set; }

    /// <summary>oauth connectors only. Short-lived; refreshed server-side. Never egresses.</summary>
    public string? OauthAccessCiphertext { get; set; }

    /// <summary>oauth connectors only. Long-lived. Never egresses.</summary>
    public string? OauthRefreshCiphertext { get; set; }

    public string? OauthScope { get; set; }
    public DateTime? OauthExpiresAt { get; set; }

    /// <summary>Last successful call of any kind — drives the Connected status.</summary>
    public DateTime? LastOkAt { get; set; }

    /// <summary>An error_code from the §4 taxonomy, never a raw exception.</summary>
    public string? LastErrorCode { get; set; }
    public DateTime? LastErrorAt { get; set; }

    public DateTime CreatedAt { get; set; }
}

/// <summary>
/// Which connector answers a given capability, for a given user (§2).
///
/// The primary key is <c>(UserId, Capability)</c>, which is the exclusivity rule expressed as a
/// constraint rather than as application code: one row can exist per user per capability, so
/// assigning is an upsert and "two connectors hold pr.questions" is unrepresentable. The spec
/// models this as a <c>text[]</c> column on the connector, which SQLite has no equivalent for and
/// which could not carry this constraint anyway.
/// </summary>
public class ConnectorCapability
{
    public string UserId { get; set; } = default!;

    /// <summary>Currently only 'pr.questions'.</summary>
    public string Capability { get; set; } = default!;

    public string ConnectorId { get; set; } = default!;
    public DateTime AssignedAt { get; set; }
}
