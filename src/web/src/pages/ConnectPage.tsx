import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import type { User } from "../types";

export function ConnectPage({ onConnected }: { onConnected: (u: User) => void }) {
  const [org, setOrg] = useState("");
  const [pat, setPat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.config().then((c) => setOrg((o) => o || c.defaultOrg)).catch(() => {});
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await api.connect(pat.trim(), org.trim() || undefined);
      onConnected(user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not connect.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="connect">
      <form className="panel" onSubmit={submit}>
        <h1>
          Pipeline <span>Launchpad</span>
        </h1>
        <p className="lede">
          Connect with an Azure DevOps personal access token to browse and run
          your pipelines. Your token is stored encrypted on the server and never
          leaves it.
        </p>

        {error && <div className="error" style={{ marginBottom: 16 }}>{error}</div>}

        <div className="field">
          <label className="label">Organization</label>
          <input
            className="input"
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            placeholder="BetagyDevOps"
            autoComplete="off"
          />
        </div>

        <div className="field">
          <label className="label">Personal access token</label>
          <input
            className="input"
            type="password"
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            placeholder="Paste your PAT (needs Build read/execute)"
            autoComplete="off"
          />
          <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
            Scopes: <code>Build (Read &amp; execute)</code>,{" "}
            <code>Code (Read)</code>, <code>Project (Read)</code>.
          </div>
        </div>

        <button className="btn primary" style={{ width: "100%" }} disabled={busy || !pat.trim()}>
          {busy ? <><span className="spin" /> Connecting…</> : "Connect"}
        </button>
      </form>
    </div>
  );
}
