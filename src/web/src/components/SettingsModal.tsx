import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { getSettings, setSettings } from "../lib/settings";
import { ensureNotifyPermission } from "../lib/notify";
import type { AzureCredential, ConfigRegistry, VaultRegistry } from "../types";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState(getSettings());

  function update(next: typeof s) {
    setS(next);
    setSettings(next);
  }

  const denied = "Notification" in window && Notification.permission === "denied";

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 560 }}>
        <div className="modal-head">
          <div className="title">Notifications &amp; stores</div>
          <button className="btn ghost small" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {/* Theme and presentation preferences live in the settings gear menu —
              that is the only theme control (§2.1). */}
          <div className="field">
            <label className="label">Desktop notifications</label>
            <label className="row" style={{ gap: 8, cursor: "pointer" }}>
              <input type="checkbox" checked={s.notifications}
                onChange={(e) => { const on = e.target.checked; update({ ...s, notifications: on }); if (on) ensureNotifyPermission(); }} />
              <span>Notify me when a run or sequence finishes</span>
            </label>
            {s.notifications && denied && (
              <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
                Your browser is blocking notifications for this site — enable them in the browser’s site settings.
              </div>
            )}
          </div>

          <AzureCredentialSection />
          <ConfigRegistriesSection />
          <VaultRegistriesSection />
        </div>
      </div>
    </div>
  );
}

function AzureCredentialSection() {
  const qc = useQueryClient();
  const credQ = useQuery<AzureCredential>({ queryKey: ["azure-credential"], queryFn: api.azureCredential });
  const [tenantId, setTenantId] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => api.setAzureCredential(tenantId.trim(), clientId.trim(), clientSecret.trim()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["azure-credential"] }); setClientSecret(""); setError(null); },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not save credential."),
  });
  const clear = useMutation({
    mutationFn: () => api.clearAzureCredential(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["azure-credential"] }); setTenantId(""); setClientId(""); setClientSecret(""); },
  });

  const cred = credQ.data;

  return (
    <div className="field">
      <label className="label">Azure service principal (for Key Vault &amp; endpoint-URL config)</label>
      <div className="faint" style={{ fontSize: 12, marginBottom: 8 }}>
        An Entra ID app registration (App registrations → new → client secret), granted read access to your vaults/stores.
        Required for Key Vault; also used for App Configuration added by endpoint URL. Not needed for connection-string stores.
        {cred?.configured && <> Currently configured{cred.clientId ? ` (client ${cred.clientId})` : ""}.</>}
      </div>
      {error && <div className="error" style={{ fontSize: 12, marginBottom: 8 }}>{error}</div>}
      <input className="input" placeholder="Tenant ID" value={tenantId} onChange={(e) => setTenantId(e.target.value)} style={{ marginBottom: 6 }} />
      <input className="input" placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} style={{ marginBottom: 6 }} />
      <input className="input" type="password" placeholder={cred?.configured ? "Client secret (enter to replace)" : "Client secret"} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} style={{ marginBottom: 6 }} />
      <div className="row">
        <button className="btn small primary" disabled={!tenantId.trim() || !clientId.trim() || !clientSecret.trim() || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save credential"}
        </button>
        {cred?.configured && <button className="btn ghost small" onClick={() => clear.mutate()}>Clear</button>}
      </div>
    </div>
  );
}

function VaultRegistriesSection() {
  const qc = useQueryClient();
  const registriesQ = useQuery<VaultRegistry[]>({ queryKey: ["vault-registries"], queryFn: api.vaultRegistries });
  const [name, setName] = useState("");
  const [vaultUri, setVaultUri] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () => api.addVaultRegistry(name.trim(), vaultUri.trim()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vault-registries"] }); setName(""); setVaultUri(""); setError(null); },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not add vault."),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteVaultRegistry(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vault-registries"] }),
  });

  const registries = registriesQ.data ?? [];

  return (
    <div className="field">
      <label className="label">Azure Key Vaults</label>
      <div className="faint" style={{ fontSize: 12, marginBottom: 8 }}>
        Add a vault by URI (e.g. <code>https://my-vault.vault.azure.net</code>). Authenticates with the service principal above; secret values are only fetched when you reveal them.
      </div>

      {registries.map((r) => (
        <div className="row" key={r.id} style={{ marginBottom: 6 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
            <div className="faint" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.endpoint}</div>
          </div>
          <button className="btn ghost small" onClick={() => remove.mutate(r.id)}>Remove</button>
        </div>
      ))}

      {error && <div className="error" style={{ fontSize: 12, margin: "8px 0" }}>{error}</div>}

      <div style={{ marginTop: 8 }}>
        <input className="input" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} style={{ marginBottom: 6 }} />
        <input className="input" placeholder="Vault URI (https://…vault.azure.net)" value={vaultUri} onChange={(e) => setVaultUri(e.target.value)} style={{ marginBottom: 6 }} />
        <button className="btn small primary" disabled={!vaultUri.trim() || add.isPending} onClick={() => add.mutate()}>
          {add.isPending ? "Validating…" : "+ Add vault"}
        </button>
      </div>
    </div>
  );
}

function ConfigRegistriesSection() {
  const qc = useQueryClient();
  const registriesQ = useQuery<ConfigRegistry[]>({ queryKey: ["config-registries"], queryFn: api.configRegistries });
  const [name, setName] = useState("");
  const [connection, setConnection] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () => api.addConfigRegistry(name.trim(), connection.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["config-registries"] });
      setName(""); setConnection(""); setError(null);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not add registry."),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteConfigRegistry(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["config-registries"] }),
  });

  const registries = registriesQ.data ?? [];

  return (
    <div className="field">
      <label className="label">Azure App Configuration registries</label>
      <div className="faint" style={{ fontSize: 12, marginBottom: 8 }}>
        Paste an Azure App Configuration connection string. Stored encrypted; shown on the Configurations tab.
      </div>

      {registries.map((r) => (
        <div className="row" key={r.id} style={{ marginBottom: 6 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
            <div className="faint" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.endpoint}</div>
          </div>
          <button className="btn ghost small" onClick={() => remove.mutate(r.id)}>Remove</button>
        </div>
      ))}

      {error && <div className="error" style={{ fontSize: 12, margin: "8px 0" }}>{error}</div>}

      <div style={{ marginTop: 8 }}>
        <input className="input" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} style={{ marginBottom: 6 }} />
        <input className="input" placeholder="Connection string" value={connection} onChange={(e) => setConnection(e.target.value)} style={{ marginBottom: 6 }} />
        <button className="btn small primary" disabled={!connection.trim() || add.isPending} onClick={() => add.mutate()}>
          {add.isPending ? "Validating…" : "+ Add registry"}
        </button>
      </div>
    </div>
  );
}
