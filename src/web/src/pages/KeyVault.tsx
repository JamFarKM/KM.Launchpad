import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { VaultRegistry, VaultSecretValue } from "../types";

export function KeyVaultPage() {
  const registriesQ = useQuery<VaultRegistry[]>({ queryKey: ["vault-registries"], queryFn: api.vaultRegistries });
  const registries = registriesQ.data ?? [];
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (registries.length > 0 && (!activeId || !registries.some((r) => r.id === activeId))) {
      setActiveId(registries[0].id);
    }
  }, [registries, activeId]);

  const active = registries.find((r) => r.id === activeId) ?? null;

  return (
    <div className="body">
      <div className="main">
        {registries.length > 0 && (
          <div className="tabs">
            {registries.map((r) => (
              <button key={r.id} className={`tab ${r.id === activeId ? "active" : ""}`} onClick={() => setActiveId(r.id)} title={r.endpoint}>
                {r.name}
              </button>
            ))}
          </div>
        )}

        <div className="view-area cfg-area">
          {registriesQ.isLoading && <div className="center-note"><span className="spin" /> Loading vaults…</div>}

          {!registriesQ.isLoading && registries.length === 0 && (
            <div className="empty">
              <h3>No key vaults yet</h3>
              <p>Add Azure Key Vaults in <b>Settings ⚙️</b> by their URI (e.g. <code>https://my-vault.vault.azure.net</code>). Secret names are listed here; values stay hidden until you reveal them.</p>
            </div>
          )}

          {active && <VaultSecrets key={active.id} registry={active} />}
        </div>
      </div>
    </div>
  );
}

function VaultSecrets({ registry }: { registry: VaultRegistry }) {
  const [q, setQ] = useState("");
  const secretsQ = useQuery<string[]>({
    queryKey: ["vault-secrets", registry.id],
    queryFn: () => api.vaultSecrets(registry.id),
  });

  const needle = q.trim().toLowerCase();
  const names = useMemo(
    () => (secretsQ.data ?? []).filter((n) => !needle || n.toLowerCase().includes(needle)),
    [secretsQ.data, needle],
  );

  return (
    <div className="cfg-registry-body">
      <div className="cfg-registry-head">
        <div className="faint" style={{ fontSize: 12 }}>{registry.endpoint}</div>
        <span style={{ flex: 1 }} />
        <button className="btn ghost small icon-btn" title="Refresh" disabled={secretsQ.isFetching} onClick={() => secretsQ.refetch()}>
          <svg className={secretsQ.isFetching ? "spin-svg" : ""} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M23 4v6h-6" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
        <input className="input" style={{ maxWidth: 260 }} placeholder="Filter secrets…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {secretsQ.isLoading && <div className="center-note"><span className="spin" /> loading secrets…</div>}
      {secretsQ.error && (
        <div className="error">{secretsQ.error instanceof ApiError ? secretsQ.error.message : "Could not read this vault."}</div>
      )}

      {secretsQ.data && (
        <div className="cfg-tree-wrap">
          <div className="cfg-tree">
            {names.length === 0 && <div className="faint" style={{ padding: 12 }}>No matching secrets.</div>}
            {names.map((name) => <SecretRow key={name} registryId={registry.id} name={name} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function SecretRow({ registryId, name }: { registryId: string; name: string }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  const valueQ = useQuery<VaultSecretValue>({
    queryKey: ["vault-secret", registryId, name],
    queryFn: () => api.vaultSecret(registryId, name),
    enabled: revealed,
    staleTime: 60_000,
  });

  async function copy() {
    if (!valueQ.data?.value) return;
    try {
      await navigator.clipboard.writeText(valueQ.data.value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  }

  return (
    <div className="kv-row">
      <span className="kv-name" title={name}>{name}</span>
      <span className="kv-value">
        {!revealed && <span className="faint">••••••••••••</span>}
        {revealed && valueQ.isLoading && <span className="faint">revealing…</span>}
        {revealed && valueQ.error && (
          <span className="faint">{valueQ.error instanceof ApiError ? valueQ.error.message : "failed to read"}</span>
        )}
        {revealed && valueQ.data && <span className="kv-secret">{valueQ.data.value}</span>}
      </span>
      {revealed && valueQ.data?.value && (
        <button className="btn ghost small" onClick={copy}>{copied ? "Copied ✓" : "Copy"}</button>
      )}
      <button className="btn ghost small" onClick={() => setRevealed((r) => !r)}>
        {revealed ? "Hide" : "Reveal"}
      </button>
    </div>
  );
}
