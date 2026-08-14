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

/// <summary>
/// A reviewer's conversation about one pull request (DESIGN_SPEC_CONNECTORS.md §7.5).
///
/// Keyed on the reviewer plus the pull request, and private to them. Launchpad owns the thread
/// rather than the connector: that is what keeps connectors stateless and therefore
/// interchangeable, and it is why a thread survives swapping the provider underneath it —
/// mid-conversation if need be.
/// </summary>
public class AgentThread
{
    public string Id { get; set; } = default!;
    public string UserId { get; set; } = default!;
    public string Project { get; set; } = "";
    public string RepoId { get; set; } = "";
    public int PullRequestId { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}

/// <summary>
/// One question and its answer.
///
/// <b>Turns outlive the connector that produced them.</b> §7.5: a thread is a record of what the
/// reviewer asked, and removing an agent does not un-ask it. So there is deliberately no foreign
/// key to <see cref="Connector"/> — a cascade here would delete the reviewer's history as a side
/// effect of changing agents — and <see cref="ConnectorName"/> is denormalised alongside the id,
/// because §7.4's "— via {name}" attribution has to still render after the connector is gone.
/// </summary>
public class AgentThreadTurn
{
    public string Id { get; set; } = default!;
    public string ThreadId { get; set; } = default!;

    /// <summary>Position in the thread, from 1. Ordering by time would tie on a fast exchange.</summary>
    public int Ordinal { get; set; }

    public string Question { get; set; } = "";

    /// <summary>
    /// The segments' prose, joined. Replayed verbatim; never the JSON envelope around it.
    ///
    /// Its own column rather than derived on read, because replay and the reviewer's "Copy all" both
    /// want exactly this — and because it is all a turn written before the segment shape existed has.
    /// </summary>
    public string Answer { get; set; } = "";

    /// <summary>
    /// JSON array of the canonical segment shape (§5.2) — the answer as the panel renders it.
    ///
    /// Null on turns written before provenance and citations moved into each segment. Those are read
    /// back as one synthesised segment from the three legacy columns below, so an existing thread
    /// stays readable instead of being migrated or dropped.
    /// </summary>
    public string? SegmentsJson { get; set; }

    /// <summary>
    /// Legacy: the whole answer's provenance, from before it moved into each segment. No longer
    /// written; still read, for turns that predate the change.
    /// </summary>
    public string? Provenance { get; set; }

    /// <summary>Legacy: the answer's pooled citations. Same treatment as <see cref="Provenance"/>.</summary>
    public string CitationsJson { get; set; } = "[]";

    /// <summary>Legacy: the whole answer's hedge. Same treatment as <see cref="Provenance"/>.</summary>
    public string? InferenceNote { get; set; }

    /// <summary>structured | fencedjson | unverified — decides whether this is postable (§7.4).</summary>
    public string Mode { get; set; } = "structured";

    /// <summary>May point at a connector that no longer exists. Not a foreign key, by design.</summary>
    public string? ConnectorId { get; set; }

    /// <summary>Kept so attribution survives the connector's deletion.</summary>
    public string? ConnectorName { get; set; }

    public string? Model { get; set; }

    /// <summary>The PR head this was answered against — drives the stale-commit banner (§7.3).</summary>
    public string? CommitSha { get; set; }

    /// <summary>
    /// Reported by the provider when it reports them. Recorded now because it is impossible
    /// retroactively, and BETBOT_INTEGRATION_PLAN.md's third ask wants per-reviewer cost.
    /// </summary>
    public int? PromptTokens { get; set; }
    public int? CompletionTokens { get; set; }

    /// <summary>Stopped by the reviewer. Kept in the thread, but not postable (§5.5).</summary>
    public bool Stopped { get; set; }

    /// <summary>A §4 code when the answer failed or was cut short. Never a raw exception.</summary>
    public string? ErrorCode { get; set; }

    public DateTime CreatedAt { get; set; }
}
